.data
myvar: .word 3
.text
main:

# print myvar
la $t1, myvar
lw $a0, ($t1)
li $v0, 1
syscall

# set myvar to 5
li $t2, 5
sw $t2, ($t1)
lw $a0, ($t1)

syscall


li $v0, 10
syscall
