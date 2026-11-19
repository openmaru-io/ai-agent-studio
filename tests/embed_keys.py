# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""임베드 위젯 시험용 RSA 키와 RS256 서명(OMAI-1873). 순수 Python — 이미지·시험 환경에 cryptography 가 없다.

키는 시험 프로세스에서 한 번 만들고 다시 쓴다(2048비트 하나에 1초 안팎).
"""
from __future__ import annotations

import base64
import json
import secrets

_SMALL = [p for p in range(3, 2000, 2) if all(p % d for d in range(3, int(p ** 0.5) + 1, 2))]


def _probable_prime(n: int, rounds: int = 24) -> bool:
    if n < 2:
        return False
    for p in _SMALL:
        if n % p == 0:
            return n == p
    d, r = n - 1, 0
    while d % 2 == 0:
        d //= 2
        r += 1
    for _ in range(rounds):
        a = secrets.randbelow(n - 3) + 2
        x = pow(a, d, n)
        if x in (1, n - 1):
            continue
        for _ in range(r - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _prime(bits: int) -> int:
    while True:
        c = secrets.randbits(bits) | (3 << (bits - 2)) | 1
        if _probable_prime(c):
            return c


class Key:
    def __init__(self, bits: int = 2048, e: int = 65537):
        while True:
            p, q = _prime(bits // 2), _prime(bits // 2)
            phi = (p - 1) * (q - 1)
            if p != q and phi % e:
                break
        self.n, self.e, self.d = p * q, e, pow(e, -1, phi)
        self.k = (self.n.bit_length() + 7) // 8

    def jwk(self, kid: str = "", private: bool = False) -> dict:
        out = {"kty": "RSA", "use": "sig", "alg": "RS256", "n": b64(_int_bytes(self.n)), "e": b64(_int_bytes(self.e))}
        if kid:
            out["kid"] = kid
        if private:
            out["d"] = b64(_int_bytes(self.d))
        return out

    def sign_raw(self, data: bytes) -> bytes:
        from aas.auth import embed
        m = int.from_bytes(embed.emsa_pkcs1_v15(data, self.k), "big")
        return pow(m, self.d, self.n).to_bytes(self.k, "big")


def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _int_bytes(v: int) -> bytes:
    return v.to_bytes((v.bit_length() + 7) // 8, "big")


def jwt(claims: dict, key: Key, kid: str = "", alg: str = "RS256", header: dict | None = None) -> str:
    h = {"alg": alg, "typ": "JWT", **({"kid": kid} if kid else {}), **(header or {})}
    signing = f"{b64(json.dumps(h).encode())}.{b64(json.dumps(claims).encode())}"
    return f"{signing}.{b64(key.sign_raw(signing.encode()))}"


_keys: dict[str, Key] = {}


def key(name: str) -> Key:
    if name not in _keys:
        _keys[name] = Key()
    return _keys[name]
