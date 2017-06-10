.data
myvar: .word 3
.text
times_four:
    li $a1, 4
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
    la $t1, times_four
    jal $t1
    syscall

    li $v0, 10
    syscall
