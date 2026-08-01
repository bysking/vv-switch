/**
 * Middleware pipeline — composes middleware functions into a single callable
 */

export type MiddlewareFn = (ctx: Record<string, unknown>, next: () => Promise<unknown>) => Promise<unknown>;

/**
 * Creates a composed middleware pipeline from an array of middleware functions.
 * Each middleware receives the context and a next() function to call the next middleware.
 *
 * 注意：支持 retry 场景 —— 一个 middleware 可以在 catch 中再次调用 next()。
 * 但同一个 next() 不能在同一次执行中被调用两次（防止无限循环）。
 */
export function createMiddlewarePipeline(
  middlewares: MiddlewareFn[],
): (ctx: Record<string, unknown>, terminal: () => Promise<unknown>) => Promise<unknown> {
  return (ctx: Record<string, unknown>, terminal: () => Promise<unknown>): Promise<unknown> => {
    // index 记录当前"正在执行"的 middleware 下标，用于检测单次 next() 被多次调用
    let index = -1;

    const dispatch = async (i: number): Promise<unknown> => {
      // 如果 i <= index，意味着同一次 dispatch 中 next() 被调用了多次
      if (i <= index) {
        throw new Error('next() called multiple times');
      }
      index = i;

      if (i === middlewares.length) {
        // 到达终端前，重置 index，允许 retry middleware 再次调用
        index = -1;
        return terminal();
      }

      const middleware = middlewares[i];
      try {
        const result = await middleware(ctx, () => dispatch(i + 1));
        // middleware 成功完成后，重置 index，允许 retry 场景下再次调用
        index = -1;
        return result;
      } catch (err) {
        // middleware 抛出异常后，重置 index，允许 retry middleware 再次调用 next()
        index = -1;
        throw err;
      }
    };

    return dispatch(0);
  };
}
