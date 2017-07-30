.data
myglobal: .word 0
myfuncptr: .word 0
.text
printmyglobal:
lw $a0, myglobal
li $v0, 1
syscall
jr $ra

main:
li $a0, 5
sw $a0, myglobal

jal printmyglobal

li $a0, 6
sw $a0, myglobal
jal printmyglobal

la $a2, printmyglobal
jal $a2

sw $a2 myfuncptr
lw $a3 myfuncptr

jal $a3

li $a0, 7
sw $a0, myglobal
jal $a3

li $v0, 10
syscall
