# Compare runs

A single run says little: with another seed the same setup kills a few more or a few less. To tell whether a change
helps, run each variant on several seeds and compare the means.

## Several seeds

```sh
for s in 1 2 3 4 5; do chronal run my.json --seed $s; done
```

On the dashboard, runs of one setup (same characters, CODE, world and ChronAL version; any seed) fold into a group
row, and the group's numbers are the mean +/- sd over its seeds. From a run, **Rerun** with Runs set to 5 starts seeds
from the next one up; past the free CPU threads they queue.

## A sweep

One setting at a time, every value as its own setup:

```sh
chronal new --template my.json --sweep-gear Ran1:mainhand=bow+8,firebow+7,crossbow+5 --seeds 1,2,3,4,5 --run
chronal new --template my.json --sweep-gear-set Ran1=ranger-early,ranger-mid,ranger-late --seeds 1,2,3,4,5 --run
chronal new --template my.json --sweep-code-set mine,mine@HEAD~1 --seeds 1,2,3,4,5 --run
```

The setups are saved in a folder of config `setups_dir` (`setups/<name>-<MMDD-HHMM>/`, one file per value). `--run`
prints a table of the means per variant at the end. In the dashboard's New sim, **Compare items** in a gear
slot's picker, **Compare sets** under Gear set, or several CODE sets, does the same; a run's Rerun (Advanced: Sweep) sweeps duration, warm-up, world
age, ping or account age.

## Read the comparison

1. Pick the groups (or runs) to compare with their checkboxes in the runs list, then click **Compare** under it.
   The comparison has its own URL (`#/compare?ids=...`): the first series is the baseline.
2. Click a series' column head to make it the baseline.
3. **Summary**: each metric shows every series' mean and its change from the baseline. The change is coloured only
   when Welch's t-test gives p < 0.05; else it is within the seeds' noise. With fewer than 2 runs on a side it says
   "noise unknown": add seeds.
4. The other tabs show the series side by side: the **Data** panels' meters and breakdowns as a bar per series with an
   sd whisker (a click on a bar shows its runs as dots), over time as a mean line with an sd band.

Series whose setups differ in exactly one setting are a sweep: the dashboard plots the metric against that setting.

## Rerun a run exactly, or with current CODE

Every run stores its resolved setup and CODE. Its side file runs it again:

```sh
chronal run live/<id>.setup.json                  # the same run (same seed and duration: identical)
chronal run live/<id>.setup.json --current-code   # with the CODE as it is now (rebuilt)
chronal run live/<id>.setup.json --seed 7 --duration 2h
```

A run's **Rerun** (the New sim page, from that run) does the same, and its dry run says what will differ (CODE hashes,
account age, an identical run).
