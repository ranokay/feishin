export const waitFor = async (
    predicate: () => boolean,
    timeoutMs = 8000,
    message = 'timed out waiting for condition',
): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error(message);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};
