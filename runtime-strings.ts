export const errors = {
    freeNull: { name: 'tried_to_free_null', value: 'Tried to free null pointer! Exiting.' },
    doubleFree: { name: 'double_free', value: 'Double free detected! Exiting.' },
    allocationFailed: { name: 'sbrk_failed', value: 'Memory allocation failed! Exiting.' },
    leaksDetected: { name: 'leaks_found_error', value: 'Leaks detected! Exiting.' },
    allocatedZero: {
        name: 'zero_memory_malloc_error',
        value: 'Zero memory requested! Exiting.',
    },
    printFailed: { name: 'print_failed', value: 'Print Failed! Exiting.' },
    readIntFailed: {
        name: 'read_int_failed',
        value: 'Reading Integer from stdin failed! Exiting.',
    },
};
