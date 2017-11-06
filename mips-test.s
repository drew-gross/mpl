.data
factorial: .word 0


.text
length:
# Always store return address
sw $ra, ($sp)
addiu $sp, $sp, -4
# Store two temporaries
sw $t1, ($sp)
addiu $sp, $sp, -4
sw $t2, ($sp)
addiu $sp, $sp, -4

# Set length count to 0
li $t1, 0
length_loop:
# Load char into temporary
lb $t2, ($s0)
# If char is null, end of string. Return count.
beq $t2, 0, length_return
# Else bump pointer count and and return to start of loop
addiu $t1, $t1, 1
addiu $s0, $s0, 1
b length_loop

length_return:
# Put length in return register
move $a0, $t1

# Restore two temporaries
addiu $sp, $sp, 4
lw $t2, ($sp)
addiu $sp, $sp, 4
lw $t1, ($sp)
# Always restore return address
addiu $sp, $sp, 4
lw $ra, ($sp)
jr $ra

anonymous_2:
# Always store return address
sw $ra, ($sp)
addiu $sp, $sp, -4
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
# Store left side of equality in temporary
# Move from x ($s0) into destination ($t2)
move $t2, $s0
# Store right side of equality in temporary
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
# Store left side of product in temporary ($t2)
# Move from x ($s0) into destination ($t2)
move $t2, $s0
# Store right side of product in destination ($a0)
# Put argument in $s0
# Store left side in temporary ($t4)
# Move from x ($s0) into destination ($t4)
move $t4, $s0
# Store right side in destination ($s0)
li $s0, 1
# Evaluate subtraction
sub $s0, $t4, $s0
# call factorial
# Call global function
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
addiu $sp, $sp, 4
lw $ra, ($sp)
# Always restore return address
jr $ra
main:

# factorial ($t0) = anonymous_2
la $t0, anonymous_2
# evaluate expression of return statement, put in $a0
# Put argument in $s0
li $s0, 5
# call factorial
# Call global function
lw $t1, factorial
jal $t1
# move result from $a0 into destination
move $a0, $a0

# print "exit code" and exit
li $v0, 1
syscall
li $v0, 10
syscall
