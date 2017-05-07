import test from 'ava';

import { parse, evaluate } from './compiler';

test('parse empty file', t => {
    t.deepEqual(parse(''), {
        statements: [],
    });
});

test('parse single number', t => {
    t.deepEqual(parse('7'), {
        statements: [
            '7',
        ],
    });
});

test('evaluate single number', t => {
    t.deepEqual(evaluate(parse('7')), 7);
});
