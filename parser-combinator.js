const alternative = parsers => (tokens, index) => {
    for (const parser of parsers) {
        const result = parser(tokens, index);
        if (result.success) {
            return result;
        }
    }
    return { success: false };
}

const sequence = parsers => (tokens, index) => {
    const results = []
    for (const parser of parsers) {
        const result = parser(tokens, index);
        if (!result.success) {
            return { success: false };
        }
        results.push(result.children);
        index = result.newIndex;
    }
    return {
        success: true,
        newIndex: index,
        children: results,
    };
}

const terminal = terminal => (tokens, index) => {
    if (tokens[index].type == terminal) {
        return {
            success: true,
            newIndex: index + 1,
            children: tokens[index],
            type: terminal,
        };
    }

    return { success: false };
}

module.exports = { alternative, sequence, terminal };
