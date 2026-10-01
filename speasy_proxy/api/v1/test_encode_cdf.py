import numpy as np
import pycdfpp
from speasy.core.data_containers import DataContainer, VariableTimeAxis
from speasy.products import SpeasyVariable

from speasy_proxy.api.v1.get_data import encode_output

# 2030-01-01 as CDF TT2000 ns: the Epoch VALIDMAX CDAWeb ships (e.g. PSP_SWP_SPC_L3I)
TT2000_2030 = 946728068183000000


def _variable_with_epoch_validmax():
    time = np.datetime64("2021-01-01", "ns") + np.arange(3).astype("timedelta64[s]")
    return SpeasyVariable(
        axes=[VariableTimeAxis(values=time, meta={"VALIDMIN": [-315575942816000000],
                                                  "VALIDMAX": [TT2000_2030]})],
        values=DataContainer(values=np.zeros((3, 1)), meta={}, name="v"))


def test_cdf_keeps_a_large_positive_int_attribute():
    data, mime = encode_output(_variable_with_epoch_validmax(), "cda/x/v", "", "", "cdf", request=None)
    assert mime == "application/x-cdf"
    cdf = pycdfpp.load(data)
    assert cdf[cdf["v"].attributes["DEPEND_0"][0]].attributes["VALIDMAX"][0] == [TT2000_2030]
