"""Safety parameters used to build the no-go mask and the cost grid.

D6 replaces each PROVISIONAL value with a cited one (or labels it an assumption).
Every entry: value, unit, source (citation or "ASSUMPTION"), status.
"""
PARAMS = {
    "slope_soft_deg": {"value": 15.0, "unit": "deg", "source": "PROVISIONAL", "status": "to cite in D6"},
    "slope_hard_deg": {"value": 25.0, "unit": "deg", "source": "PROVISIONAL", "status": "to cite in D6"},
    "rough_hard_m": {"value": 0.5, "unit": "m (detrended height std, 8 m window)", "source": "PROVISIONAL", "status": "to cite in D6"},
}

def v(name):
    return PARAMS[name]["value"]
