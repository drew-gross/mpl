.text

main:
# Store left side in destination ($a0)

# Store left side in destination ($a0)

li $a0, 3

# Store right side in temporary ($t1)

li $t1, 4

# Evaluate product
mult $a0, $t1
# Move result to final destination (assume no overflow)
mflow $a0

# Store right side in temporary ($t0)

li $t0, 5

# Evaluate product
mult $a0, $t0
# Move result to final destination (assume no overflow)
mflow $a0

# print "exit code" and exit
li $v0, 1
syscall
li $v0, 10
syscall
