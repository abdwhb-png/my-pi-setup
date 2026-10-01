const logicalHomes = new Set(['linuxbrew', 'sandbox']);

export function containsPersonalHome(value) {
    return (
        typeof value === 'string' &&
        [...value.matchAll(/\/home\/([a-z_][a-z0-9_-]*)/g)].some(
            (match) => !logicalHomes.has(match[1].toLowerCase()),
        )
    );
}

export default {
    meta: { name: 'pi-portability' },
    rules: {
        'no-personal-home': {
            meta: {
                type: 'problem',
                schema: [],
                messages: {
                    personalHome:
                        'Use a configured or home-relative path instead of a personal absolute home.',
                },
            },
            create(context) {
                const check = (node, value) => {
                    if (containsPersonalHome(value))
                        context.report({ node, messageId: 'personalHome' });
                };
                return {
                    Literal(node) {
                        check(node, node.value);
                    },
                    TemplateElement(node) {
                        check(node, node.value.cooked ?? node.value.raw);
                    },
                };
            },
        },
    },
};
