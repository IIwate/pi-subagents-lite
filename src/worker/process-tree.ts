import { closeSync, openSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import koffi from "koffi";

/** Runs only in the supervisor, before any child resource is loaded. */
export function createProcessTree(path: string) {
  if (process.platform === "linux") return linuxTree(path);
  if (process.platform === "win32") return windowsTree(path);
  throw new Error("Worker execution requires Linux or Windows process supervision");
}

function linuxTree(path: string) {
  const libc = koffi.load(null);
  const flock = libc.func("int flock(int fd, int operation)");
  const prctl = libc.func("int prctl(int option, unsigned long value, unsigned long a, unsigned long b, unsigned long c)");
  const waitpid = libc.func("int waitpid(int pid, _Out_ int *status, int options)");
  const fd = openSync(`${path}.lock`, "a", 0o600);
  try {
    if (flock(fd, 2 | 4) !== 0) throw new Error("Task storage is owned by another worker supervisor");
    if (prctl(36, 1, 0, 0, 0) !== 0) throw new Error("Cannot establish worker child subreaper");
  } catch (error) { closeSync(fd); throw error; }
  return {
    attach(_pid: number): void { /* Descendants inherit the supervisor's ancestry, including detached process groups. */ },
    async drain(): Promise<void> {
      // Killing an adopted parent reparents its children here. Reap before reading
      // again, so PID reuse cannot turn a stale tree snapshot into a foreign kill.
      while (true) {
        const children = readFileSync(`/proc/self/task/${process.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
        if (!children.length) return;
        for (const pid of children) {
          try { process.kill(pid, "SIGKILL"); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            // The adopted child may have exited between enumeration and kill.
          }
          while (waitpid(pid, [0], 0) < 0) {
            const error = koffi.errno();
            if (error === 10) break; // libuv may already have reaped an exited child.
            if (error !== 4) throw new Error(`Cannot reap worker descendant ${pid}: errno ${error}`);
          }
        }
      }
    },
    close(): void { closeSync(fd); },
  };
}

function windowsTree(path: string) {
  const kernel = koffi.load("kernel32.dll");
  const basic = koffi.struct({ PerProcessUserTimeLimit: "int64_t", PerJobUserTimeLimit: "int64_t", LimitFlags: "uint32_t",
    MinimumWorkingSetSize: "uintptr_t", MaximumWorkingSetSize: "uintptr_t", ActiveProcessLimit: "uint32_t",
    Affinity: "uintptr_t", PriorityClass: "uint32_t", SchedulingClass: "uint32_t" });
  const counters = koffi.struct(Object.fromEntries(["ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
    "ReadTransferCount", "WriteTransferCount", "OtherTransferCount"].map(key => [key, "uint64_t"])));
  const extended = koffi.struct({ BasicLimitInformation: basic, IoInfo: counters, ProcessMemoryLimit: "uintptr_t",
    JobMemoryLimit: "uintptr_t", PeakProcessMemoryUsed: "uintptr_t", PeakJobMemoryUsed: "uintptr_t" });
  const accounting = koffi.struct({ TotalUserTime: "int64_t", TotalKernelTime: "int64_t", ThisPeriodTotalUserTime: "int64_t",
    ThisPeriodTotalKernelTime: "int64_t", TotalPageFaultCount: "uint32_t", TotalProcesses: "uint32_t",
    ActiveProcesses: "uint32_t", TotalTerminatedProcesses: "uint32_t" });
  const createFile = kernel.func("void * __stdcall CreateFileW(str16 path, uint32_t access, uint32_t sharing, void *security, uint32_t disposition, uint32_t flags, void *templateFile)");
  const createJob = kernel.func("void * __stdcall CreateJobObjectW(void *attributes, str16 name)");
  const setInfo = kernel.func("__stdcall", "SetInformationJobObject", "int", ["void *", "int", koffi.pointer(extended), "uint32_t"]);
  const query = kernel.func("__stdcall", "QueryInformationJobObject", "int", ["void *", "int", koffi.out(koffi.pointer(accounting)), "uint32_t", "void *"]);
  const openProcess = kernel.func("void * __stdcall OpenProcess(uint32_t access, int inheritHandle, uint32_t pid)");
  const assign = kernel.func("int __stdcall AssignProcessToJobObject(void *job, void *process)");
  const terminate = kernel.func("int __stdcall TerminateJobObject(void *job, uint32_t exitCode)");
  const close = kernel.func("int __stdcall CloseHandle(void *handle)");
  const lastError = kernel.func("uint32_t __stdcall GetLastError(void)");
  const wait = promisify(kernel.func("uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)").async);
  const invalid = (handle: any) => !handle || koffi.address(handle) === (1n << BigInt(koffi.sizeof("void *") * 8)) - 1n;
  const lease = createFile(`${path}.lock`, 0xc0000000, 0, null, 4, 0x80, null);
  if (invalid(lease)) throw new Error(`Task storage is owned or inaccessible: Windows error ${lastError()}`);
  const job = createJob(null, null);
  try {
    if (!job) throw new Error(`Cannot create worker job: Windows error ${lastError()}`);
    const limits = koffi.decode(Buffer.alloc(koffi.sizeof(extended)), extended) as any;
    limits.BasicLimitInformation.LimitFlags = 0x2000;
    if (!setInfo(job, 9, limits, koffi.sizeof(extended))) throw new Error(`Cannot configure worker job: Windows error ${lastError()}`);
  } catch (error) { if (job) close(job); close(lease); throw error; }
  return {
    attach(pid: number): void {
      const child = openProcess(0x0100 | 0x0001, 0, pid);
      if (!child) throw new Error(`Cannot open worker process: Windows error ${lastError()}`);
      try { if (!assign(job, child)) throw new Error(`Cannot assign worker job: Windows error ${lastError()}`); }
      finally { close(child); }
    },
    async drain(): Promise<void> {
      if (!terminate(job, 1)) throw new Error(`Cannot terminate worker job: Windows error ${lastError()}`);
      while (true) {
        const value: { ActiveProcesses?: number } = {};
        if (!query(job, 1, value, koffi.sizeof(accounting), null)) throw new Error(`Cannot inspect worker job: Windows error ${lastError()}`);
        if (value.ActiveProcesses === 0) return;
        // Query confirms termination even when job notifications are missed.
        if (await wait(job, 100) === 0xffffffff) throw new Error(`Cannot wait for worker job: Windows error ${lastError()}`);
      }
    },
    close(): void { close(job); close(lease); },
  };
}
