.data
myvar: .word 3
.text

anonymous_2:

li $t1, 11

move $v0, $t1

jr $ra

main:
# $t1 = takeItToEleven
la $t1, anonymous_2



# la $t1, $t1
jal $t1


move $a0, $v0
li $v0, 1
syscall
li $v0, 10
syscall
