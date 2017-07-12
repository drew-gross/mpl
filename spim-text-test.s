.text
 anonymous_2:
 sw $t1, ($sp)
 addiu $sp, $sp, -4
 sw $t0, ($sp)
 addiu $sp, $sp, -4
 # evaluate expression of return statement, put in $a0
 # Compute boolean and store in temporary
 # Store left side in temporary
 # Move from five ($s0) into destination ($t2)
 move $t2, $s0
 # Store right side in temporary
 li $t1, 5

 # Goto set 1 if equal
 beq $t2, $t1, L2
 # Not equal, set 0
 li $t1, 0
 # And goto exit
 b L3
 L2
 li $t1, 1
 L3
 # Go to false branch if zero
 beq $t1, $0, L0
 # Execute true branch
 li $a0, 2

 # Jump to end of ternary
 b L1
 L0:
 # Execute false branch
 li $a0, 7

 # End of ternary label
 L1:
 addiu $sp, $sp, 4
 lw $t0, ($sp)
 addiu $sp, $sp, 4
 lw $t1, ($sp)
 jr $ra
 main:
 # isFive ($t0) = anonymous_2
 la $t0, anonymous_2
 # evaluate expression of return statement, put in $a0
 # Put argument in $s0
 li $s0, 5

 # call isFive ($t0)
 jal $t0
 # move result from $a0 into destination
 move $a0, $a0
 # print "exit code" and exit
 li $v0, 1
 syscall
 li $v0, 10
 syscall
