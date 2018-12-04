type TestCase = {
    name: string;
    exitCode: number;
    source: string;
    failing?: boolean;
};

export default TestCase;
