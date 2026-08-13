/**
 * Raw access to the two external sources that outrank the persisted document
 * for operational settings. The port exposes each source separately so the
 * precedence decision stays in the configuration core instead of leaking into
 * a platform adapter.
 */
export interface EnvironmentSource {
  /** Process environment variable, or undefined when unset. */
  variable(name: string): string | undefined;
  /** Value from the composition-root-selected `.env` file, or undefined when absent. */
  dotEnvValue(name: string): string | undefined;
}
