/**
 * Counts the D1 queries of one Worker invocation, so the cron can stay inside the free plan's 50
 * (docs/database.md, "Free tier"). Every statement counts, each statement of a `db.batch` too.
 * Work that might not fit asks `left()` first, against its most queries, and waits for the next
 * run when it's short.
 */
export interface QueryBudget {
  /** Use this one instead of the real database: its queries are counted. */
  db: D1Database;
  used(): number;
  /** Queries still allowed. */
  left(): number;
}

const runs = new Set<PropertyKey>(["first", "all", "run", "raw"]);

export function queryBudget(db: D1Database, limit: number): QueryBudget {
  let used = 0;
  // The real statement behind each counted one: `batch` needs the real ones.
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const counted = new Proxy(statement, {
      get(target, prop) {
        if (prop === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== "function") return value;
        if (runs.has(prop)) {
          return (...args: unknown[]) => {
            used += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
    real.set(counted, statement);
    return counted;
  };
  const counted = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (query: string) => wrap(target.prepare(query));
      if (prop === "batch") {
        return (statements: D1PreparedStatement[]) => {
          used += statements.length;
          return target.batch(statements.map((s) => real.get(s) ?? s));
        };
      }
      if (prop === "exec") {
        return (query: string) => {
          used += 1;
          return target.exec(query);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db: counted, used: () => used, left: () => limit - used };
}
