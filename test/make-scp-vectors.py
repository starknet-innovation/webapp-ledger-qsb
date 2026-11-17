# Generates test vectors from ledgerblue's own HexLoader (SCP v3 with an ECDH secret).
import json, hashlib
from ledgerblue.hexLoader import HexLoader
from importlib.metadata import version

class Card:
    def apduMaxDataSize(self): return 255

def loader(secret):
    return HexLoader(Card(), 0xE0, True, {"ecdh_secret": secret, "devicePublicKey": b""})

out = {"ledgerblue": version("ledgerblue"), "cases": []}
for seed in [b"qsb-vector-1", b"qsb-vector-2", b"qsb-vector-3"]:
    secret = hashlib.sha256(seed).digest()
    host, device = loader(secret), loader(secret)
    case = {"secret": secret.hex(), "encKey": host.scp_enc_key.hex(), "macKey": host.scp_mac_key.hex(), "steps": []}
    messages = [b"\x0c\x03QSB", bytes(range(27)), b"\x06\x00\x00" + bytes(208), b"\x07", bytes(15), bytes(16), b"\x09"]
    for i, m in enumerate(messages):
        wrapped = host.scpWrap(m)
        assert device.scpUnwrap(bytes(wrapped)) == m
        step = {"command": m.hex(), "wrapped": bytes(wrapped).hex()}
        if i % 2 == 1:  # every other command gets an answer with data, which chains the IVs too
            answer = hashlib.sha256(m).digest()[: 5 + i]
            reply = device.scpWrap(answer)
            assert host.scpUnwrap(bytes(reply)) == answer
            step["answer"] = answer.hex(); step["wrappedAnswer"] = bytes(reply).hex()
        case["steps"].append(step)
    out["cases"].append(case)
print(json.dumps(out, indent=1))
