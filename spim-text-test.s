.data
myvar: .word 3
.text
times_three:
    li $a1, 3
    mult $a0, $a1
    mflo $a0
    jr $ra

main:

    # print myvar
    la $t1, myvar
    lw $a0, ($t1)
    li $v0, 1
    syscall

    # multiply by three
    jal times_three
    syscall

    li $v0, 10
    syscall
