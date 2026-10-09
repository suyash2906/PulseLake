"""PulseLake kill switch.

Triggered by AWS Budgets (via SNS) when the project's real usage cost crosses a threshold.
If the cost is at/over the cap for the current phase (testing or demo) it:
  1. disables every IoT topic rule named pulselake_*  -> no more Firehose/Lambda work
  2. attaches an explicit Deny iot:* policy to the Cognito guest role -> phones and
     dashboard can no longer connect/publish
Re-enabling is deliberately manual: scripts/phase.ps1.

Can also be invoked directly with {"action": "kill"} or {"action": "status"}.
"""
import json
import os
import re
import time

import boto3

iot = boto3.client("iot")
iam = boto3.client("iam")
ssm = boto3.client("ssm")

GUEST_ROLE = os.environ["GUEST_ROLE_NAME"]
PHASE_PARAM = os.environ["PHASE_PARAM"]
STATUS_PARAM = os.environ["STATUS_PARAM"]
RULE_PREFIX = "pulselake_"
DENY_POLICY_NAME = "pulselake-kill-switch-deny"
CAPS = {"testing": float(os.environ.get("TESTING_CAP", "9")), "demo": float(os.environ.get("DEMO_CAP", "22"))}

AMOUNT_PATTERNS = [
    re.compile(r"ACTUAL Amount:\s*\$\s*([0-9,]+(?:\.[0-9]+)?)"),
    re.compile(r"associated with this budget is \$\s*([0-9,]+(?:\.[0-9]+)?)"),
]


def parse_actual(message: str):
    for pattern in AMOUNT_PATTERNS:
        m = pattern.search(message)
        if m:
            return float(m.group(1).replace(",", ""))
    return None


def current_phase() -> str:
    try:
        return ssm.get_parameter(Name=PHASE_PARAM)["Parameter"]["Value"]
    except Exception:
        return "testing"  # safest (lowest) cap


def kill(reason: str) -> dict:
    disabled = []
    token = None
    while True:
        page = iot.list_topic_rules(**({"nextToken": token} if token else {}))
        for rule in page.get("rules", []):
            if rule["ruleName"].startswith(RULE_PREFIX) and not rule.get("ruleDisabled"):
                iot.disable_topic_rule(ruleName=rule["ruleName"])
                disabled.append(rule["ruleName"])
        token = page.get("nextToken")
        if not token:
            break

    iam.put_role_policy(
        RoleName=GUEST_ROLE,
        PolicyName=DENY_POLICY_NAME,
        PolicyDocument=json.dumps(
            {"Version": "2012-10-17", "Statement": [{"Effect": "Deny", "Action": "iot:*", "Resource": "*"}]}
        ),
    )
    status = f"KILLED {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} - {reason}"
    ssm.put_parameter(Name=STATUS_PARAM, Value=status[:4000], Type="String", Overwrite=True)
    print(json.dumps({"killed": True, "reason": reason, "rulesDisabled": disabled}))
    return {"killed": True, "rulesDisabled": disabled, "reason": reason}


def handler(event, _context):
    if event.get("action") == "kill":
        return kill("manual")
    if event.get("action") == "status":
        return {"phase": current_phase(), "caps": CAPS}

    phase = current_phase()
    cap = CAPS.get(phase, CAPS["testing"])
    for record in event.get("Records", []):
        message = record.get("Sns", {}).get("Message", "")
        actual = parse_actual(message)
        print(json.dumps({"phase": phase, "cap": cap, "actual": actual}))
        if actual is None:
            # Could not read the amount -> fail safe.
            return kill(f"unparsed budget alert in phase {phase}")
        if actual >= cap:
            return kill(f"usage ${actual:.2f} >= {phase} cap ${cap:.2f}")
    return {"killed": False, "phase": phase, "cap": cap}
