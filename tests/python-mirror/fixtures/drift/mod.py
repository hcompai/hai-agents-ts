"""Drift fixture: one of each thing drift.mjs reads from a Python module."""

LIMIT = 3
TIMEOUT_S = 2.0
NAME = "fixture"
URL = "https://x.example/y"  # a comment after a literal that holds //
_PRIVATE = 1


class Thing:
    pass


def do_thing(x):
    if x is None:
        raise ValueError(f"x is required (got {x!r})")
    raise RuntimeError("gone, said python")


async def async_do_thing(x):
    return await x


def _helper():
    pass
