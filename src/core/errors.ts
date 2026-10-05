export const EXIT = {
  OK: 0,
  CHECK_FAILED: 1,
  INVALID_MANIFEST: 2,
  BROKEN_CASCADE: 3,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

export class PlugboardError extends Error {
  constructor(
    message: string,
    readonly exit: ExitCode,
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'PlugboardError'
  }
}

export class InvalidManifestError extends PlugboardError {
  constructor(readonly file: string, detail: string) {
    super(`Manifesto inválido: ${file}`, EXIT.INVALID_MANIFEST, detail)
    this.name = 'InvalidManifestError'
  }
}

export class BrokenCascadeError extends PlugboardError {
  constructor(message: string, detail?: string) {
    super(message, EXIT.BROKEN_CASCADE, detail)
    this.name = 'BrokenCascadeError'
  }
}
