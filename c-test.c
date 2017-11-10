#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

int length(char *str) {
  int len = 0;
  while (*str++ && ++len) {
  }
  return len;
}

void string_copy(char *in, char *out) {
  while ((*out++ = *in++)) {
  }
}

char *str1;
char *str2;

char *a = "a";
char *b = "b";

int main(int argc, char **argv) {
  str1 = malloc(length(a));
  string_copy(str1, a);
  str2 = malloc(length(b));
  string_copy(str2, b);
  uint8_t result = str1 == str2 ? 1 : 2;

  return result;
}
