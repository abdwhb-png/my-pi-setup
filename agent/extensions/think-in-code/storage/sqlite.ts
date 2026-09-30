import type { Database as BunDatabase } from "bun:sqlite";
import { createRequire } from "node:module";

// The store uses positional bindings only. Keep the runtime difference here;
// callers retain one schema and one transaction path on either SQLite engine.
type Binding = string | number | bigint | null | Uint8Array;

interface Statement<Row, Params extends Binding[]> {
    all(...params: Params): Row[];
    get(...params: Params): Row | null | undefined;
    run(...params: Params): void;
}

export interface SqliteConnection {
    query<Row = unknown, Params extends Binding[] = Binding[]>(
        sql: string,
    ): Statement<Row, Params>;
    run(sql: string, params?: Binding[]): void;
    close(): void;
}

export function openSqlite(path: string): {
    connection: SqliteConnection;
    rawBunDatabase?: BunDatabase;
} {
    const hostRequire = createRequire(import.meta.url);
    if (typeof Bun !== "undefined") {
        const { Database } = hostRequire(
            "bun:sqlite",
        ) as typeof import("bun:sqlite");
        const database = new Database(path, { create: true });
        return {
            connection: {
                run(sql, params) {
                    if (params) database.run(sql, params);
                    else database.run(sql);
                },
                query<Row = unknown, Params extends Binding[] = Binding[]>(
                    sql: string,
                ): Statement<Row, Params> {
                    const statement = database.query<Row, Binding[]>(sql);
                    return {
                        get(...params) {
                            return statement.get(...params);
                        },
                        all(...params) {
                            return statement.all(...params);
                        },
                        run(...params) {
                            statement.run(...params);
                        },
                    };
                },
                close() {
                    database.close();
                },
            },
            rawBunDatabase: database,
        };
    }

    const { DatabaseSync } = hostRequire(
        "node:sqlite",
    ) as typeof import("node:sqlite");
    const database = new DatabaseSync(path);
    return {
        connection: {
            run(sql, params) {
                if (params) {
                    database.prepare(sql).run(...params);
                    return;
                }
                database.exec(sql);
            },
            query<Row = unknown, Params extends Binding[] = Binding[]>(
                sql: string,
            ): Statement<Row, Params> {
                const statement = database.prepare(sql);
                return {
                    get(...params) {
                        return statement.get(...params) as Row | undefined;
                    },
                    all(...params) {
                        return statement.all(...params) as Row[];
                    },
                    run(...params) {
                        statement.run(...params);
                    },
                };
            },
            close() {
                database.close();
            },
        },
    };
}
