# packages/gateway/src-native/sandbox-helper/Makefile
CC ?= cc
CFLAGS := -O2 -Wall -Wextra -Werror -std=c99 -D_GNU_SOURCE
LDFLAGS := -lcap

nimbus-sandbox-helper: main.c
	$(CC) $(CFLAGS) -o $@ main.c $(LDFLAGS)

clean:
	rm -f nimbus-sandbox-helper

.PHONY: clean
