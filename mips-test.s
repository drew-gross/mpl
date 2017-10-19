.data

test: .asciiz "test"

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
lw $t2, ($s0)
# If char is null, end of string. Return count.
beq $t2, 0, length_return
# Else bump pointer and return to start of loop
addiu $s0, $s0, 4
b length_loop

length_return:
# Put length in return register
move $a0, $t1

# Restore two temporaries
lw $t2, ($sp)
addiu $sp, $sp, 4
lw $t1, ($sp)
addiu $sp, $sp, 4
# Always restore return address
lw $ra, ($sp)
addiu $sp, $sp, 4
jr $ra


main:

# Run rhs of assignment and store to myStr ($t0)
# Load string literal address into register
la $t0, test
# evaluate expression of return statement, put in $a0
# Put argument in $s0
# Move from myStr ($t0) into destination ($s0)
move $s0, $t0
# call length
# Call runtime function
la $t1, length
jal $t1
# move result from $a0 into destination
move $a0, $a0

# print "exit code" and exit
li $v0, 1
syscall
li $v0, 10
syscall
