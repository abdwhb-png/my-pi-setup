import { posix } from 'node:path';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { ParsedPlan } from './types.ts';

const TASK_HEADING = /^### Task ([1-9][0-9]*):[ \t]+(.+)$/gm;

function canonicalizeProjectFile(file: string, taskId: string): string {
    const portable = file.trim().replaceAll('\\', '/');
    const canonical = posix.normalize(portable);
    if (
        !portable ||
        posix.isAbsolute(canonical) ||
        /^[A-Za-z]:\//.test(portable) ||
        canonical === '..' ||
        canonical.startsWith('../')
    ) {
        throw new Error(
            `${taskId} file ${JSON.stringify(file)} must stay within the project root.`,
        );
    }
    return canonical;
}

const MetadataSchema = Type.Object(
    {
        id: Type.String({ pattern: '^task-[1-9][0-9]*$' }),
        dependsOn: Type.Array(Type.String({ pattern: '^task-[1-9][0-9]*$' })),
        files: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        verify: Type.Array(
            Type.Object(
                {
                    id: Type.String({ minLength: 1 }),
                    command: Type.String({ minLength: 1 }),
                    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
                },
                { additionalProperties: false },
            ),
            { minItems: 1 },
        ),
    },
    { additionalProperties: false },
);

export function parseSddPlan(content: string): ParsedPlan {
    const titleMatches = [...content.matchAll(/^#[ \t]+(.+)$/gm)];
    const title = titleMatches[0]?.[1].trim();
    if (titleMatches.length !== 1 || !title)
        throw new Error('SDD plan requires one level-one title.');

    const matches = [...content.matchAll(TASK_HEADING)];
    if (matches.length === 0) {
        throw new Error(
            'SDD plan requires at least one exact ### Task N: Title heading.',
        );
    }

    const tasks = matches.map((match, index) => {
        const ordinal = Number(match[1]);
        if (ordinal !== index + 1) {
            throw new Error(
                'Task headings must be contiguous and ordered from 1.',
            );
        }

        const start = (match.index ?? 0) + match[0].length;
        const end = matches[index + 1]?.index ?? content.length;
        const section = content.slice(start, end);
        const metadataBlock = section.match(
            /^\s*~~~sdd-task\s*\n([\s\S]*?)\n~~~\s*\n?([\s\S]*)$/,
        );
        if (
            !metadataBlock ||
            [...section.matchAll(/^[ \t]*~~~sdd-task[ \t]*$/gm)].length !== 1
        ) {
            throw new Error(
                `Task ${match[1]} must start with exactly one ~~~sdd-task JSON block.`,
            );
        }
        let metadata: unknown;
        try {
            metadata = JSON.parse(metadataBlock[1]);
        } catch {
            throw new Error(`Task ${ordinal} metadata is invalid JSON.`);
        }
        if (!Value.Check(MetadataSchema, metadata)) {
            const errors = [...Value.Errors(MetadataSchema, metadata)]
                .map((error) => error.message)
                .join('; ');
            throw new Error(`Task ${ordinal} metadata is invalid: ${errors}`);
        }
        if (metadata.id !== `task-${ordinal}`) {
            throw new Error(
                `Task ${ordinal} metadata id must be task-${ordinal}.`,
            );
        }

        return Object.assign(metadata, {
            files: [
                ...new Set(
                    metadata.files.map((file) =>
                        canonicalizeProjectFile(file, metadata.id),
                    ),
                ),
            ],
            ordinal,
            title: match[2].trim(),
            body: metadataBlock[2].trim(),
        });
    });
    const taskIds = new Set(tasks.map((task) => task.id));
    for (const task of tasks) {
        for (const dependency of task.dependsOn) {
            if (!taskIds.has(dependency)) {
                throw new Error(
                    `${task.id} depends on unknown task ${dependency}.`,
                );
            }
            if (dependency === task.id)
                throw new Error(`${task.id} cannot depend on itself.`);
        }
    }

    return { title, tasks };
}
