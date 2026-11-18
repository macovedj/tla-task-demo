------------------------------ MODULE Task ------------------------------
\* A single task moves through three observable application states.
VARIABLE status

Init == status = "absent"

Add ==
    /\ status = "absent"
    /\ status' = "open"

Complete ==
    /\ status = "open"
    /\ status' = "done"

Reopen ==
    /\ status = "done"
    /\ status' = "open"

Delete ==
    /\ status \in {"open", "done"}
    /\ status' = "absent"

Next == Add \/ Complete \/ Reopen \/ Delete

TypeOK == status \in {"absent", "open", "done"}
=============================================================================
