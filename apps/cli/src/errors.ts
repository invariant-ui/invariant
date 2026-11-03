/** A failure to report to the user, with the exit code to use: 1 for findings, 2 for bad usage or input. */
export class CliError extends Error {
  readonly exitCode: number
  constructor(message: string, exitCode = 2) {
    super(message)
    this.name = "CliError"
    this.exitCode = exitCode
  }
}
