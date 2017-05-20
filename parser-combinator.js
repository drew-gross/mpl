const alternative = parsers => (tokens, index) => {
    for (const parser of parsers) {
        const result = parser(tokens, index);
        if (result.success) {
            return result;
        }
    }
    return { success: false };
}

const sequence = (type, parsers) => (tokens, index) => {
    const results = []
    for (const parser of parsers) {
        const result = parser(tokens, index);
        if (!result.success) {
            return { success: false };
        }
        results.push(result);
        index = result.newIndex;
    }
    return {
        success: true,
        newIndex: index,
        type: type,
        children: results,
    };
}

const terminal = terminal => (tokens, index) => {
    if (index >= tokens.length) {
        return { success: false };
    }
    if (tokens[index].type == terminal) {
        return {
            success: true,
            newIndex: index + 1,
            value: tokens[index].value,
            type: terminal,
        };
    }

    return { success: false };
}

module.exports = { alternative, sequence, terminal };