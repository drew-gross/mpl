#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

uint8_t length(char *str) {
  uint8_t len = 0;
  while (*str != 0) {
    len++;
    str++;
  }
  return len;
}

void string_copy(char *in, char *out) {
  while ((*out++ = *in++)) {
  }
}

char *testing = "testing";

int main(int argc, char **argv) {
  char *myStr1 = testing;
  char *myStr2 = malloc(length(myStr1));
  string_copy(myStr1, myStr2);
  uint8_t result = (*length)(myStr2);
  free(myStr2);
  return result;
}
