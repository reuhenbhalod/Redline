"""Central config for the Redline data pipeline.

Every source URL, path and grid constant lives here so the stage scripts never
hard-code them. Site-dependent values (box center, local CRS) are written by
D1 into data/bounds.json and read back with `load_bounds()`.
"""
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw"            # downloads and big crops, gitignored
DATA = ROOT / "data"          # files the web app and Engine read
LAYERS = DATA / "layers"
QA = ROOT / "pipeline" / "qa"  # sanity-check images

# ---- Mars body -------------------------------------------------------------
MARS_R = 3396190.0  # IAU Mars 2000 sphere radius (m), used by every source
# Geographic CRS on the Mars sphere, lon/lat in degrees (planetocentric, east).
MARS_GEOG = f"+proj=longlat +R={MARS_R} +no_defs"
# Projection shared by all source rasters: Equirectangular, standard parallel 0.
# NOT true scale at Jezero (finding 1); only used to read the sources.
SOURCE_EQC = f"+proj=eqc +lat_ts=0 +lon_0=0 +R={MARS_R} +units=m +no_defs"

def local_crs(lon0: float, lat0: float) -> str:
    """True-scale local grid centered on the box (finding 1)."""
    return f"+proj=eqc +lat_ts={lat0} +lat_0={lat0} +lon_0={lon0} +R={MARS_R} +units=m +no_defs"

# ---- Grid ------------------------------------------------------------------
BOX_M = 4000          # box side (m)
PIXEL_M = 2.0         # grid cell (m)
GRID_PX = int(BOX_M / PIXEL_M)  # 2000

# ---- Sources ---------------------------------------------------------------
TRN = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn"
HIRISE_DTM_URL = f"{TRN}/HiRISE/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif"
HIRISE_ORTHO_URL = f"{TRN}/HiRISE/JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first.tif"
CTX_DTM_URL = f"{TRN}/CTX/JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0.tif"

ZENODO_THEMIS = 4931348   # Edwards & Buz, THEMIS TI of Jezero (CC-BY-4.0)
ZENODO_CRISM = 5575824    # Parente et al., CRISM dominant mineralogy (CC-BY-4.0)
CALTECH_STACK = "a7qs5-xhq84"  # Stack et al. 2020 photogeologic map record (CC-BY-4.0)
STACK_ZIP = "11214_2020_739_MOESM3_ESM.zip"
STACK_SHP = "M2020_JEZ_geology_edited_equi0_allquads_v6_archive"

M20_WAYPOINTS_URL = "https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json"
M20_TRAVERSE_URL = "https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json"
RAW_IMAGES_API = "https://mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&feedtype=json&sol={sol}"

DEPOT_BUNDLE = "https://pds-geosciences.wustl.edu/m2020/urn-nasa-pds-mars2020_sample_depot_three_forks"
DEPOT_DROPS_URL = f"{DEPOT_BUNDLE}/data/sample_drop_events/sample_drop_timestamps.csv"

MEDA_ROOT = "https://pds-atmospheres.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda"
RAD_ROOT = "https://pds-ppi.igpp.ucla.edu/data/MSL-M-RAD-3-RDR-V1.0/DATA"
DONKI_ROOT = "https://api.nasa.gov/DONKI"

# ---- Helpers ---------------------------------------------------------------
def load_bounds() -> dict:
    return json.loads((DATA / "bounds.json").read_text())

for p in (RAW, DATA, LAYERS, QA):
    p.mkdir(parents=True, exist_ok=True)
