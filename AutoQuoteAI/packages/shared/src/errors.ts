export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function problemJson(err: AppError) {
  return {
    type: `https://autoquoteai.local/errors/${err.code}`,
    title: err.code,
    status: err.status,
    detail: err.message,
    details: err.details,
  };
}
