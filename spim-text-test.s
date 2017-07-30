.data
ternary: .word 0
.text
anonymous_2:
sw $t1, ($sp)
addiu $sp, $sp, -4
sw $t0, ($sp)
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
li $a0, 5

# End of ternary label
L1:
addiu $sp, $sp, 4
lw $t0, ($sp)
addiu $sp, $sp, 4
lw $t1, ($sp)
jr $ra
main:
# Load function ptr (anonymous_2 into current temporary ($1)
la $t1, anonymous_2
# store from temporary into global
sw $t1, ternary
# evaluate expression of return statement, put in $a0
# Put argument in $s0
li $s0, 0

# call ternary
jal ternary
# move result from $a0 into destination
move $a0, $a0
# print "exit code" and exit
li $v0, 1
syscall
li $v0, 10
syscall
