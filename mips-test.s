.data
ternaryFunc: .word 0
.text
anonymous_2:
sw $ra, ($sp)
addiu $sp, $sp, -4
sw $t2, ($sp)
addiu $sp, $sp, -4
sw $t1, ($sp)
addiu $sp, $sp, -4
# evaluate expression of return statement, put in $a0
# Compute boolean and store in temporary
# Move from a ($s0) into destination ($t1)
move $t1, $s0
# Go to false branch if zero
beq $t1, $0, L0
# Execute true branch
li $a0, 9
# Jump to end of ternary
b L1
L0:
# Execute false branch
li $a0, 3
# End of ternary label
L1:
addiu $sp, $sp, 4
lw $t1, ($sp)
addiu $sp, $sp, 4
lw $t2, ($sp)
addiu $sp, $sp, 4
lw $ra, ($sp)
jr $ra
main:

# Load function ptr (anonymous_2 into s7 (s7 used to not overlap with arg)
la $s7, anonymous_2
# store from temporary into global
sw $s7, ternaryFunc
# evaluate expression of return statement, put in $a0
# Store left side in temporary ($t1)
# Put argument in $s0
li $s0, 1
# call ternaryFunc
jal ternaryFunc
# move result from $a0 into destination
move $t1, $a0
# Store right side in destination ($a0)
# Put argument in $s0
li $s0, 0
# call ternaryFunc
jal ternaryFunc
# move result from $a0 into destination
move $a0, $a0
# Evaluate subtraction
sub $a0, $t1, $a0

# print "exit code" and exit
li $v0, 1
syscall
li $v0, 10
syscall
