.data
factorial: .word 0
.text
anonymous_2:
sw $t4, ($sp)
addiu $sp, $sp, -4
sw $t3, ($sp)
addiu $sp, $sp, -4
sw $t2, ($sp)
addiu $sp, $sp, -4
sw $t1, ($sp)
addiu $sp, $sp, -4
# evaluate expression of return statement, put in $a0
# Compute boolean and store in temporary
# Store left side in temporary
# Move from x ($s0) into destination ($t2)
move $t2, $s0
# Store right side in temporary
li $t1, 1

# Goto set 1 if equal
beq $t2, $t1, L2
# Not equal, set 0
li $t1, 0
# And goto exit
b L3
L2:
li $t1, 1
L3:
# Go to false branch if zero
beq $t1, $0, L0
# Execute true branch
li $a0, 1

# Jump to end of ternary
b L1
L0:
# Execute false branch
# Store left side in temporary ($t2)

# Move from x ($s0) into destination ($t2)
move $t2, $s0
# Store right side in destination ($a0)

# Put argument in $s0
# Store left side in temporary ($t4)

# Move from x ($s0) into destination ($t4)
move $t4, $s0
# Store right side in destination ($s0)

li $s0, 1

# Evaluate subtraction
sub $s0, $t4, $s0
# call factorial
lw $t3, factorial
jal $t3
# move result from $a0 into destination
move $a0, $a0
# Evaluate product
mult $t2, $a0
# Move result to final destination (assume no overflow)
mflo $a0
# End of ternary label
L1:
addiu $sp, $sp, 4
lw $t1, ($sp)
addiu $sp, $sp, 4
lw $t2, ($sp)
addiu $sp, $sp, 4
lw $t3, ($sp)
addiu $sp, $sp, 4
lw $t4, ($sp)
jr $ra
main:
# Load function ptr (anonymous_2 into current temporary ($1)
la $t1, anonymous_2
# store from temporary into global
sw $t1, factorial
# evaluate expression of return statement, put in $a0
# Put argument in $s0
li $s0, 5

# call factorial
lw $t1, factorial
jal $t1
# move result from $a0 into destination
move $a0, $a0
# print "exit code" and exit
li $v0, 1
syscall
li $v0, 10
syscall
