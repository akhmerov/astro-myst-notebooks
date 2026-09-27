"""A lightweight Python API for the theme example."""


def triangular(n: int) -> int:
    """Sum the integers from one to ``n``.

    Parameters
    ----------
    n : int
        The last integer to include.

    Returns
    -------
    int
        The triangular number.
    """
    return n * (n + 1) // 2
