import testCases from './test-cases.js';
import produceProgramInfo from './produceProgramInfo.js';

(() => {
    if (process.argv.length != 3) {
        console.log('Exactly one test case must be named');
        process.exit(1);
    }

    const testName = process.argv[2];

    const testCase = testCases.find(c => c.name == testName);

    if (!testCase) {
        console.log(`Could not find a test case named "${testName}"`);
        process.exit(1);
        return;
    }

    const progamInfo = produceProgramInfo(testCase.source);
})();
