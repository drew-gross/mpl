.data
myStr: .word 0
string_constant_test2: .asciiz "test2"

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


main:

# Load string ptr (test2 into s7 (s7 used to not overlap with arg)
la $s7, string_constant_test2
# store from temporary into global string
sw $s7, myStr
# evaluate expression of return statement, put in $a0
# Put argument in $s0
# Move from global myStr into destination ($s0)
la $s0, myStr
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
