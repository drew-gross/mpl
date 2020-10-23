export sum := (xs: Integer[]) => {
    result := 0;
    for (x : xs) {
        result = result + x;
    }
    return result;
}
