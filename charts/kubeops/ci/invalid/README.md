# Rejected value combinations

Every file here renders valid YAML but describes a deployment that cannot work
on a real cluster. `helm template` must fail on each one. CI asserts that, so a
guardrail cannot be removed from `_helpers.tpl` without a test turning red.

The first line of each file states the message the chart is expected to print.
