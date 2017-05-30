.text
 main:

 li $t1, 7
 sw $t1, ($sp)
 addiu $sp, $sp -4


 addiu $sp, $sp, 4
 li $v0, 1
 syscall
 li $v0, 10
 syscall
