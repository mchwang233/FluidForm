# Checks that can pass, results the user can read, and who sets the bar

What the axi-to-apb task (2 h 35 min) showed, and what changed.

## A check that runs a file no step writes

A step's check ran `verification/runs/check_collection.py`, which no step was allowed to write.
The step did its work for 21 minutes and then could not pass; the plan had to be changed.

Now, in a task with no project, the plan is sent back to the lead when a pending step's check
(`check` or its contract's `acceptance_commands`) runs a script, or a `./` path, that neither the
step nor a step it depends on writes (`contracts.unwritten_scripts`). It runs when the lead plans
(`task_planning.plan_tasks`) and when it changes the plan (`replan.change_plan`). When the plan
is changed, files already in the task's folder count as written, since earlier steps may have
written more than they listed. A project's files may already exist, so in a project nothing is
checked. Finished and running steps are not
checked, so old tasks can still be changed.

## The task's result

The task's result was the output of the last step that ran: here, a rework that added a report
rebuild script. What the module does and how far it was verified was only in the lead's reason.

Now the lead, when it ends the task (`done`), also writes `summary`: what was delivered, with
links, how it was checked, and what is not done or only partly verified, in the request's
language. It is kept on the decision (`Decision.summary`) and becomes the task's result
(`Executor._final_result`). Without one, the result is the steps' output as before; old records
have none and load as before.

## Who sets the bar

The step building the test bench wrote "every legal parameter combination" (7,632) into its own
requirements list. The report step then stopped twice over it, about 75 minutes in all.

Now every step is told that the request and the lead's criteria are the bar
(`quality.OWN_BAR`): it does not write stricter requirements for later steps, and a requirement an
earlier step set itself is an open point, not a reason to stop. When a step does stop
(blocked or unable), the lead sees the step's criteria and is asked whether the request needs
the requirement it stopped over (`supervisor.BEYOND_THE_BAR`), deciding it once.
