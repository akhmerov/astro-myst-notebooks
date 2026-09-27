"""Implementation details."""


class Result:
    """A computed result.

    See {py:func}`solve` for construction.
    """

    def __init__(self, value: int = 0):
        self.value = value

    def scale(self, factor: int = 2) -> int:
        """Multiply the result.

        Parameters
        ----------
        factor : int
            Multiplication factor.

        Returns
        -------
        int
            The scaled value.
        """
        return self.value * factor

    @property
    def doubled(self) -> int:
        """The doubled value."""
        return 2 * self.value


def solve(value: int, /, *, offset: int = 1) -> Result:
    """Produce a {py:class}`Result` with **an offset**.

    Parameters
    ----------
    value : int
        Input value.
    offset : int
        Amount to add.

    Returns
    -------
    Result
        The computed result.

    Examples
    --------
    >>> solve(2).value
    3
    """
    return Result(value + offset)
