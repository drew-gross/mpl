export const errors = {
    freeNull: { name: 'tried_to_free_null', value: 'Tried to free null pointer! Exiting.' },
    allocationFailed: { name: 'sbrk_failed', value: 'Memory allocation failed! Exiting.' },
    leaksDetected: { name: 'leaks_found_error', value: 'Leaks detected! Exiting.' },
    allocatedZero: { name: 'zero_memory_malloc_error', value: 'Zero memory requested! Exiting.' },
};
