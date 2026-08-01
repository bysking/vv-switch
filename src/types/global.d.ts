declare module 'uuid' {
  export function v4(): string;
  export function v1(): string;
}

// Migration helpers — loose types during TS migration
declare global {
  type AnyDict = Record<string, any>;
  type Maybe<T> = T | null | undefined;
  type AnyFunc = (...args: any[]) => any;
}

export {};

