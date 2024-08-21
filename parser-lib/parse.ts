import { Token as LToken } from './lex';
import debug from '../util/debug';
import { Graph } from 'graphlib';
import SourceLocation from './sourceLocation';
import { TokenSpec, lex, LexError } from './lex';
import { deepCopy } from 'deep-copy-ts';
import drain from '../util/list/drain';

type ListNode<Node, Leaf> = { items: Ast<Node, Leaf>[] };
export type SeparatedListNode<Node, Leaf> = {
    items: Ast<Node, Leaf>[];
    separators: Ast<Node, Leaf>[];
};

type LeafValue = string | number | null | undefined;

export type Ast<Node, Token> =
    | { type: Node; children: Ast<Node, Token>[]; sourceLocation: SourceLocation }
    | { type: Token | 'endOfFile'; value: LeafValue; sourceLocation: SourceLocation }
    | SeparatedListNode<Node, Token>
    | ListNode<Node, Token>;

export const isSeparatedListNode = <Node, Leaf>(
    n: Ast<Node, Leaf>
): n is SeparatedListNode<Node, Leaf> => 'items' in n && 'separators' in n;

export const isListNode = <Node, Leaf>(n: Ast<Node, Leaf>): n is ListNode<Node, Leaf> => {
    if (!n) throw debug('bad node');
    return 'items' in n && !('separators' in n);
};

interface LeafWithIndex<Token> {
    success: true;
    type: Token | 'endOfFile';
    value: LeafValue;
    sourceLocation: SourceLocation;
}

interface NodeWithIndex<Node, Leaf> {
    success: true;
    type: Node;
    children: AstWithIndex<Node, Leaf>[];
    sourceLocation: SourceLocation;
}

type AstWithIndex<Node, Token> =
    | NodeWithIndex<Node, Token>
    | LeafWithIndex<Token>
    | SeparatedListWithIndex<Node, Token>
    | ManyWithIndex<Node, Token>
    | OptionalWithIndex<Node, Token>;

type SeparatedListWithIndex<Node, Token> = {
    items: AstWithIndex<Node, Token>[];
    separators: AstWithIndex<Node, Token>[];
};

type ManyWithIndex<Node, Token> = {
    items: AstWithIndex<Node, Token>[];
};

type OptionalWithIndex<Node, Token> = {
    item: AstWithIndex<Node, Token> | undefined;
};

// TODO: just put the actual Ltoken in here instead of most of it's members
export interface ParseFailureInfo<Token> {
    found: Token | 'endOfFile';
    foundTokenText: string;
    expected: Token | 'endOfFile';
    whileParsing: string[];
    sourceLocation: SourceLocation;
}

export type ParseError<Token> = { kind: 'parseError'; errors: ParseFailureInfo<Token>[] };
export type ParseResultWithIndex<Node, Token> = ParseError<Token> | AstWithIndex<Node, Token>;
export type ParseResult<Node, Token> = ParseError<Token> | Ast<Node, Token>;

export const parseResultIsError = <Node, Leaf, Token>(
    result:
        | ParseResult<Node, Token>
        | ParseResultWithIndex<Node, Token>
        | AstWithIndex<Node, Leaf>[]
        | 'missingOptional'
): result is ParseError<Token> => {
    if (result === undefined) throw debug('bad parse result');
    return result != 'missingOptional' && 'kind' in result && result.kind == 'parseError';
};

const parseResultWithIndexIsLeaf = <Node, Token>(
    r: ParseResultWithIndex<Node, Token>
): r is LeafWithIndex<Token> => 'value' in r;

// TODO also use a real sum type
const parseResultWithIndexIsSeparatedList = <Node, Token>(
    r: ParseResultWithIndex<Node, Token>
): r is SeparatedListWithIndex<Node, Token> => 'items' in r && 'separators' in r;

const parseResultWithIndexIsList = <Node, Token>(
    r: ParseResultWithIndex<Node, Token>
): r is ManyWithIndex<Node, Token> => 'items' in r && !('separators' in r);

const stripNodeIndexes = <Node, Leaf>(r: AstWithIndex<Node, Leaf>): Ast<Node, Leaf> => {
    if (parseResultWithIndexIsLeaf(r)) {
        return { value: r.value, type: r.type, sourceLocation: r.sourceLocation };
    }
    if (parseResultWithIndexIsSeparatedList(r)) {
        return {
            items: r.items.map(stripNodeIndexes),
            separators: r.separators.map(stripNodeIndexes),
        };
    }
    if (parseResultWithIndexIsList(r)) {
        return { items: r.items.map(stripNodeIndexes) };
    }
    // TODO: Should fix optional handling to work more like the new parser when skipping missing items
    if ('item' in r) {
        throw debug('TODO: better optional handling');
    }
    if (!r.children) debug('expected children');
    const childrenWithFixedOptionals: any[] = [];
    for (const c of r.children) {
        if ('item' in c) {
            if (c.item) {
                childrenWithFixedOptionals.push(c.item);
            }
        } else {
            childrenWithFixedOptionals.push(c);
        }
    }
    return {
        type: r.type,
        children: childrenWithFixedOptionals.map(stripNodeIndexes) as any,
        sourceLocation: r.sourceLocation,
    };
};

export const stripSourceLocation = ast => {
    if ('children' in ast) {
        return { type: ast.type, children: ast.children.map(stripSourceLocation) };
    } else {
        return { type: ast.type, value: ast.value };
    }
};

type Terminal<Node, Token> = { kind: 'terminal'; token: Token };
type BaseParser<Node, Token> = string | Terminal<Node, Token>;
type Sequence<Node, Token> = { kind: 'sequence'; name: string; parsers: Parser<Node, Token>[] };
type Alternative<Node, Token> = { kind: 'oneOf'; parsers: Parser<Node, Token>[] };
type Optional<Node, Token> = { kind: 'optional'; parser: Parser<Node, Token> };
type SeparatedList<Node, Token> = {
    kind: 'separatedList';
    separator: Parser<Node, Token>;
    item: Parser<Node, Token>;
};
type Many<Node, Token> = {
    kind: 'many';
    item: Parser<Node, Token>;
};
type Nested<Node, Token> = {
    kind: 'nested';
    in: Nesting<Node, Token>;
    parser: Parser<Node, Token>;
};

type Parser<Node, Token> =
    | Alternative<Node, Token>
    | Sequence<Node, Token>
    | BaseParser<Node, Token>
    | Optional<Node, Token>
    | SeparatedList<Node, Token>
    | Many<Node, Token>
    | Nested<Node, Token>;

export const Sequence = <Node extends string, Token>(
    name: Node,
    parsers: Parser<Node, Token>[]
): Sequence<Node, Token> => ({ kind: 'sequence', name, parsers });

export const OneOf = <Node, Token>(
    parsers: Parser<Node, Token>[]
): Alternative<Node, Token> => ({ kind: 'oneOf', parsers });

export const Optional = <Node, Token>(parser: Parser<Node, Token>): Optional<Node, Token> => ({
    kind: 'optional',
    parser,
});

export const SeparatedList = <Node, Token>(
    separator: Parser<Node, Token>,
    item: Parser<Node, Token>
): SeparatedList<Node, Token> => ({ kind: 'separatedList', separator, item });

export type Nesting<Node, Token> = {
    left: Parser<Node, Token>;
    right: Parser<Node, Token>;
};

export const NestedIn = <Node, Token>(
    nesting: Nesting<Node, Token>,
    parser: Parser<Node, Token>
): Nested<Node, Token> => ({ kind: 'nested', in: nesting, parser });

export const Many = <Node, Token>(item: Parser<Node, Token>): Many<Node, Token> => ({
    kind: 'many',
    item,
});

export interface Grammar<Node, Token> {
    // Ideally would have Node instead of string here but typescript doesn't allow that.
    [index: string]: Parser<Node, Token>;
}

export const Terminal = <Node, Token>(Ltoken: Token): Terminal<Node, Token> => ({
    kind: 'terminal',
    token: Ltoken,
});

export const toDotFile = <Node extends string, Token>(ast: Ast<Node, Token>) => {
    const digraph = new Graph();
    let id = 0;
    const traverse = (node: Ast<Node, Token>): number => {
        const myId = id;
        id++;

        let children: Ast<Node, Token>[] = [];
        let nodeString = '';
        if (isSeparatedListNode(node)) {
            // TODO: make this prettier as a node within the tree than just "seplist"
            nodeString = 'seplist';
            // TODO: interleave the items and separators for better display
            children = [...node.items, ...node.separators];
        } else if (isListNode(node)) {
            // TODO: make this prettier as a node within the tree than just "list"
            nodeString = 'list';
            children = node.items;
        } else if ('children' in node) {
            nodeString = node.type;
            children = node.children;
        } else {
            nodeString = `${node.type}\n${node.value ? node.value : ''}`;
        }

        // Create a new graphviz node for this ast node
        digraph.setNode(myId, { label: nodeString });

        // Recursively create nodes for this node's children
        const childIds = children.map(traverse);

        // Add an edge from this node to each child
        // @ts-ignore
        children.forEach((child, index) => {
            digraph.setEdge(myId, childIds[index]);
        });
        return myId;
    };
    traverse(ast);
    return digraph;
};

type PartialAst<Node, Token> =
    | EmptySlot<Node, Token>
    | PartialToken<Token>
    | PartialMany<Node, Token>
    | PartialSequence<Node, Token>
    | EmptySeparatedList
    | PartialSeparatedList<Node, Token>
    | PartialNested<Node, Token>
    | PartialOptional<Node, Token>;
type PartialSequence<Node, Token> = {
    sequenceItems: PartialAst<Node, Token>[];
    name: string;
    sourceLocation: SourceLocation;
};
type EmptySeparatedList = {
    emptySeparatedList: true;
};
// TOOD: Maybe use separate types for many/separated list with and without more items?
type PartialMany<Node, Token> = {
    items: PartialAst<Node, Token>[];
    remainingItems?: PartialMany<Node, Token>;
};
type PartialSeparatedList<Node, Token> = {
    item: PartialAst<Node, Token>;
    separator?: PartialAst<Node, Token>;
    remainingItems?: PartialSeparatedList<Node, Token>;
};
type PartialToken<Token> = {
    tokenType: Token;
    value: LeafValue;
    ltoken: LToken<Token>;
};
type PartialNested<Node, Token> = {
    left: PartialAst<Node, Token>;
    enclosed: PartialAst<Node, Token>;
    right: PartialAst<Node, Token>;
};
type PartialOptional<Node, Token> = {
    present: boolean;
    item?: PartialAst<Node, Token>;
};
type EmptySlot<Node, Token> = {
    rule: Parser<Node, Token>;
};
type ExpectedToken<Token> = {
    expected: Token | 'endOfFile';
};

type PotentialAstsResult<Node, Token> = {
    partial: PartialAst<Node, Token>;
    madeProgress: boolean;
};
const getPotentialAsts = <Node extends string, Token>(
    grammar: Grammar<Node, Token>,
    parser: Parser<Node, Token>,
    token: LToken<Token> | 'endOfFile'
): PotentialAstsResult<Node, Token>[] | ExpectedToken<Token> => {
    if (parser === undefined) throw debug('bad parser');
    if (typeof parser == 'string') return getPotentialAsts(grammar, grammar[parser], token);
    switch (parser.kind) {
        case 'terminal':
            if (token === 'endOfFile') {
                return { expected: parser.token };
            }
            if (parser.token === token.type) {
                return [
                    {
                        partial: { tokenType: token.type, value: token.value, ltoken: token },
                        madeProgress: true,
                    },
                ];
            } else {
                return { expected: parser.token };
            }
        case 'many': {
            const result = getPotentialAsts(grammar, parser.item, token);
            // If we didn't parse an item, we have completed the many items
            const parsesWithNoItems: PotentialAstsResult<Node, Token>[] = [
                { partial: { items: [] }, madeProgress: false },
            ];

            if ('expected' in result) {
                return parsesWithNoItems;
            }
            // If we did parse an item, there also might still be more items, so indicate that we need to try parsing another item
            const parsesWithMoreItems = result.map(({ partial, madeProgress }) => ({
                // TODO: rename items to item since it no longer contains multiple and it's more like a linked list
                partial: { items: [partial], remainingItems: { rule: parser } },
                madeProgress: madeProgress,
            })) as any;
            return [...parsesWithMoreItems, ...parsesWithNoItems];
        }
        case 'oneOf':
            let error: ExpectedToken<Token> | undefined = undefined;
            const partials: PotentialAstsResult<Node, Token>[] = [];
            for (const p of parser.parsers) {
                const result = getPotentialAsts(grammar, p, token);
                if ('expected' in result) {
                    error = result;
                } else {
                    partials.push(...result);
                }
            }
            if (partials.length > 0) {
                return partials;
            }
            if (error === undefined) throw debug('wat');
            return error;
        case 'sequence': {
            // TODO: We only seem to use the first element?
            for (const seqParser of parser.parsers) {
                const result = getPotentialAsts(grammar, seqParser, token);
                if ('expected' in result) {
                    return result;
                }
                const empties: PartialAst<Node, Token>[] = parser.parsers.map(p => ({
                    rule: p,
                }));
                // remove first element and replace it with successful partial parse
                empties.shift();
                return result.map(({ partial, madeProgress, ...rest }) => ({
                    partial: {
                        sequenceItems: [{ ...partial, ...rest }, ...empties],
                        name: parser.name,
                        sourceLocation:
                            token !== 'endOfFile'
                                ? token.sourceLocation
                                : { column: 0, line: 0 },
                    },
                    madeProgress: madeProgress,
                }));
            }
            throw debug('All optionals of sequence missing');
        }
        case 'optional': {
            const missingOptional = { partial: { present: false }, madeProgress: false };
            const result = getPotentialAsts(grammar, parser.parser, token);
            if ('expected' in result) {
                return [missingOptional];
            } else {
                return [
                    missingOptional,
                    ...result.map(({ partial, madeProgress }) => ({
                        partial: { present: true, item: partial },
                        madeProgress: madeProgress,
                    })),
                ];
            }
        }
        case 'nested': {
            const result = getPotentialAsts(grammar, parser.in.left, token);
            if ('expected' in result) {
                return result;
            }
            return result.map(({ partial, madeProgress }) => ({
                partial: {
                    left: partial,
                    enclosed: { rule: parser.parser },
                    right: { rule: parser.in.right },
                },
                madeProgress,
            }));
        }
        case 'separatedList': {
            const result = getPotentialAsts(grammar, parser.item, token);
            const parsesWithNoItems: PotentialAstsResult<Node, Token>[] = [
                { partial: { emptySeparatedList: true }, madeProgress: false },
            ];
            if ('expected' in result) {
                return parsesWithNoItems;
            }
            // TODO: Include already parsed items and separators somehow
            const parsesWithNoMoreItems = result.map(({ partial, madeProgress }) => ({
                partial: { item: partial },
                madeProgress: madeProgress,
            }));
            const parsesWithMoreItems = result.map(({ partial, madeProgress }) => ({
                partial: {
                    item: partial,
                    separator: { rule: parser.separator },
                    remainingItems: { rule: parser },
                },
                madeProgress,
            }));
            // NOTE: Need to handle the case where the token indicates that we could parse an item, but
            // the item after that indicates that we can't, and we need to successfully parse a zero item
            // separated list, followed by a successful parse of whatever comes next
            return [...parsesWithNoMoreItems, ...parsesWithMoreItems, ...parsesWithNoItems];
        }
        default: {
            throw debug(`unhandled parser kind`);
        }
    }
};

const getRuleForNextEmptySlot = <Node, Token>(
    ast: PartialAst<Node, Token>
): Parser<Node, Token> | undefined => {
    if ('rule' in ast) {
        return ast.rule as any;
    } else if ('sequenceItems' in ast) {
        for (const item of ast.sequenceItems) {
            if ('rule' in item) {
                return item.rule;
            }
            const nextSequenceItemRule = getRuleForNextEmptySlot(item);
            if (nextSequenceItemRule) {
                return nextSequenceItemRule;
            }
        }
        return undefined;
    } else if ('tokenType' in ast) {
        return undefined;
    } else if ('present' in ast) {
        if (!ast.present) {
            return undefined;
        } else if (ast.item) {
            return getRuleForNextEmptySlot(ast.item);
        } else {
            throw debug('bad item');
        }
    } else if ('left' in ast) {
        const left = getRuleForNextEmptySlot(ast.left);
        if (left) {
            return left;
        }
        const enclosed = getRuleForNextEmptySlot(ast.enclosed);
        if (enclosed) {
            return enclosed;
        }
        return getRuleForNextEmptySlot(ast.right);
    } else if ('separator' in ast) {
        // If the last item isn't finished, we need to finish it before looking for the separator
        const item = getRuleForNextEmptySlot(ast.item);
        if (item) {
            return item;
        }
        // If there is no separator there is no next item
        if (!ast.separator) {
            return undefined;
        }
        // If the last separator isn't finished, finish the separator
        const sep = getRuleForNextEmptySlot(ast.separator);
        if (sep) {
            return sep;
        }
        // If there is no option for a new item, this node is finished
        if (!ast.remainingItems) {
            return undefined;
        }
        // Otherwise finish the next item
        return getRuleForNextEmptySlot(ast.remainingItems);
    } else if ('item' in ast) {
        return getRuleForNextEmptySlot(ast.item);
    } else if ('emptySeparatedList' in ast) {
        return undefined;
    } else if ('items' in ast) {
        // many
        // first try to finish any in-progress items
        for (const item of ast.items) {
            const itemRule = getRuleForNextEmptySlot(item);
            if (itemRule) {
                return itemRule;
            }
        }
        // then try to start a new item
        if ('remainingItems' in ast) {
            // many with more items
            return getRuleForNextEmptySlot(ast.remainingItems as PartialMany<Node, Token>);
        }
        // then, return that we've completed the many
        return undefined;
    }
    throw debug(`unhandled: ${ast}`);
};
const replaceRuleForNextEmptySlotWithPartial = <Node, Token>(
    ast: PartialAst<Node, Token>,
    replacement: PartialAst<Node, Token>
): boolean => {
    if ('rule' in ast) {
        delete (ast as any).rule;
        Object.assign(ast, replacement);
        return true;
    } else if ('sequenceItems' in ast) {
        for (const item of ast.sequenceItems) {
            if (replaceRuleForNextEmptySlotWithPartial(item, replacement)) {
                return true;
            }
        }
        return false;
    } else if ('tokenType' in ast) {
        return false;
    } else if ('present' in ast) {
        if (!ast.present) {
            return false;
        } else if (ast.item) {
            return replaceRuleForNextEmptySlotWithPartial(ast.item, replacement);
        } else {
            throw debug('bad item');
        }
    } else if ('left' in ast) {
        if (replaceRuleForNextEmptySlotWithPartial(ast.left, replacement)) {
            return true;
        }
        if (replaceRuleForNextEmptySlotWithPartial(ast.enclosed, replacement)) {
            return true;
        }
        return replaceRuleForNextEmptySlotWithPartial(ast.right, replacement);
    } else if ('separator' in ast) {
        if (replaceRuleForNextEmptySlotWithPartial(ast.item, replacement)) {
            return true;
        }
        if (
            ast.separator &&
            replaceRuleForNextEmptySlotWithPartial(ast.separator, replacement)
        ) {
            return true;
        }
        if (!ast.remainingItems) {
            return false;
        }
        return replaceRuleForNextEmptySlotWithPartial(ast.remainingItems, replacement);
    } else if ('item' in ast) {
        return replaceRuleForNextEmptySlotWithPartial(ast.item, replacement);
    } else if ('emptySeparatedList' in ast) {
        return false;
    } else if ('items' in ast) {
        // Replace in the next in-progress item
        for (const item of ast.items) {
            const replaced = replaceRuleForNextEmptySlotWithPartial(item, replacement);
            if (replaced) {
                return true;
            }
        }
        // If no in-progress items, start the next item
        if ('remainingItems' in ast) {
            return replaceRuleForNextEmptySlotWithPartial(
                ast.remainingItems as any,
                replacement
            );
        }
        // Otherwise, continue to the next rule
        return false;
    }
    throw debug(`unhandled: ${ast}`);
};

const partialAstToCompleteAst = <Node, Token>(
    ast: PartialAst<Node, Token>
): AstWithIndex<Node, Token> => {
    if ('rule' in ast) {
        throw debug('was supposed to be complete');
    } else if ('items' in ast) {
        const flattenRemainingItems = (many: PartialMany<Node, Token>) => {
            const remaining: PartialAst<Node, Token>[] = many.remainingItems
                ? flattenRemainingItems(many.remainingItems)
                : [];
            return [...many.items, ...remaining];
        };
        return {
            items: flattenRemainingItems(ast).map(partialAstToCompleteAst),
        };
    } else if ('sequenceItems' in ast) {
        const sequenceHasTrailingMissingOptional = seq => {
            const backItem = seq[seq.length - 1];
            return backItem && 'rule' in backItem && backItem.rule.kind == 'optional';
        };
        while (sequenceHasTrailingMissingOptional(ast.sequenceItems)) {
            ast.sequenceItems.pop();
        }
        return {
            success: true,
            type: ast.name as Node,
            children: ast.sequenceItems.map(partialAstToCompleteAst),
            sourceLocation: ast.sourceLocation,
        };
    } else if ('tokenType' in ast) {
        return {
            success: true,
            type: ast.tokenType,
            value: ast.value,
            sourceLocation: ast.ltoken.sourceLocation,
        };
    } else if ('left' in ast) {
        // TODO: Return into about the separators? Maybe only if asked.
        return partialAstToCompleteAst(ast.enclosed);
    } else if ('emptySeparatedList' in ast) {
        return {
            items: [],
            separators: [],
        };
    } else if ('present' in ast) {
        if (ast.present) {
            return { item: partialAstToCompleteAst(ast.item as any) };
        } else {
            return { item: undefined };
        }
    } else if ('separator' in ast) {
        const flattenPartialSeparatedList = (list: PartialSeparatedList<Node, Token>) => {
            const item = partialAstToCompleteAst(list.item);
            const newSeparators = list.separator
                ? [partialAstToCompleteAst(list.separator)]
                : [];
            const { items, separators } = list.remainingItems
                ? flattenPartialSeparatedList(list.remainingItems)
                : { items: [], separators: [] };
            return { items: [item, ...items], separators: [...newSeparators, ...separators] };
        };
        return flattenPartialSeparatedList(ast);
    } else if ('item' in ast) {
        return {
            items: [partialAstToCompleteAst(ast.item)],
            separators: [],
        };
    }
    throw debug(`unhandled conversion: ${ast}`);
};

// TODO: Return errors OR partials, at this layer we don't need both.
const applyTokenToPartialParse = <Node, Token>(
    grammar: Grammar<Node, Token>,
    partial: PartialAst<Node, Token>,
    token: LToken<Token>
): { errors: ExpectedToken<Token>[]; partials: PartialAst<Node, Token>[] } => {
    const partials: PartialAst<Node, Token>[] = [];
    let rule = getRuleForNextEmptySlot(partial);
    if (!rule) {
        return { errors: [{ expected: 'endOfFile' }], partials };
    }
    const result = getPotentialAsts(grammar, rule, token);
    let errors: ExpectedToken<Token>[] = [];
    // Couldn't find any valid continuations: Must be an error
    if ('expected' in result) {
        errors.push(result);
    } else {
        for (const newProgress of result) {
            // If we used the token, hooray! Return the new partial tree
            if (newProgress.madeProgress) {
                const existingProgress = deepCopy(partial);
                if (
                    replaceRuleForNextEmptySlotWithPartial(existingProgress, newProgress.partial)
                ) {
                    partials.push(existingProgress);
                }
            } else {
                // If we found a missing optional or an empty list, we need to apply the token to the next item.
                const existingProgress = deepCopy(partial);
                if (
                    !replaceRuleForNextEmptySlotWithPartial(
                        existingProgress,
                        newProgress.partial
                    )
                ) {
                    throw debug(
                        'should have replaced I think? being here implies we should be replacing something with a missing optional/empty list'
                    );
                }
                const appliedToNext = applyTokenToPartialParse(grammar, existingProgress, token);
                errors.push(...appliedToNext.errors);
                partials.push(...appliedToNext.partials);
            }
        }
    }
    return { errors, partials };
};

export const parse = <Node extends string, Token>(
    grammar: Grammar<Node, Token>,
    rule: Node,
    tokens: LToken<Token>[]
): ParseResult<Node, Token> => {
    let ruleParser: Parser<Node, Token> = grammar[rule];
    if (!ruleParser) throw debug(`invalid rule name: ${rule}`);
    let potentialAsts: PartialAst<Node, Token>[] = [{ rule: ruleParser }] as any;
    for (const token of tokens) {
        const errors: ExpectedToken<Token>[] = [];
        const partials: PartialAst<Node, Token>[] = [];
        for (const potentialAst of potentialAsts) {
            const { errors: newErrors, partials: newPartials } = applyTokenToPartialParse(
                grammar,
                potentialAst,
                token
            );
            partials.push(...newPartials);
            errors.push(...newErrors);
        }
        if (partials.length == 0) {
            return {
                kind: 'parseError',
                errors: errors.map(expectedToken => ({
                    expected: expectedToken.expected,
                    found: token.type,
                    foundTokenText: token.string,
                    sourceLocation: token.sourceLocation,
                    whileParsing: [rule],
                })),
            };
        }
        potentialAsts = partials;
    }
    const completeAsts: PartialAst<Node, Token>[] = [];
    const incompleteAsts: PartialAst<Node, Token>[] = [];
    drain(potentialAsts, ast => {
        const rule = getRuleForNextEmptySlot(ast);
        if (!rule) {
            completeAsts.push(ast);
            return;
        }
        const newAsts = getPotentialAsts(grammar, rule, 'endOfFile');
        if ('expected' in newAsts) {
            incompleteAsts.push(ast);
            return;
        }
        for (const newAst of newAsts) {
            const extended = deepCopy(ast);
            replaceRuleForNextEmptySlotWithPartial(extended, newAst.partial);
            potentialAsts.push(extended);
        }
    });
    if (completeAsts.length > 1) {
        // TODO:TAC parser contains some real ambiguities (loadImmediate vs assign when data is a number)
        // but by coincidence, the first parse is the correct one, so for the tac parser, skip this check
        if (!('global' in grammar)) {
            throw debug('ambiguous parse');
        }
    }
    if (completeAsts.length < 1) {
        // TODO: give good error about extra tokens
        throw debug('no parse');
    }
    return stripNodeIndexes(partialAstToCompleteAst(completeAsts[0]));
};

export const parseString = <Node extends string, Token>(
    tokens: TokenSpec<Token>[],
    grammar: Grammar<Node, Token>,
    rule: any,
    input: string
): ParseResult<Node, Token> | { errors: LexError | ParseFailureInfo<Token>[] } => {
    const lexed = lex(tokens, input);
    if ('kind' in lexed) return { errors: lexed };
    const parsed = parse(grammar, rule, lexed);
    if (parseResultIsError(parsed)) {
        return { errors: parsed.errors };
    }
    return parsed;
};
