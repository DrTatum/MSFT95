export class AppError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export const bad = (code: string, msg: string) => new AppError(400, code, msg);
export const denied = (code: string, msg: string) => new AppError(403, code, msg);
export const conflict = (code: string, msg: string) => new AppError(409, code, msg);
