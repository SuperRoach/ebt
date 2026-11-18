#include "../WifiTelemetry/gnss_motion.h"

#include <cassert>

int main() {
  const auto gps = readGnssMotion("0", "");
  const auto gnss = readGnssMotion("12.3", "270");
  const auto invalid = readGnssMotion("-1", "360.1");
  assert(gps.speed.valid());
  assert(!gps.heading.valid());
  assert(!invalid.speed.valid());
  assert(!invalid.heading.valid());
  assert(!readGnssMotion("nan", "20garbage").speed.valid());
  assert(!readGnssMotion("nan", "20garbage").heading.valid());

  assert(selectMotion(gps.speed, gnss.speed, true).value == 0);
  assert(selectMotion(invalid.speed, gnss.speed, true).value == 12.3);
  assert(selectMotion(gps.heading, gnss.heading, true).value == 270);
  assert(selectMotion(invalid.speed, gnss.speed, false).source == nullptr);
  assert(selectMotion(gps.heading, gnss.heading, false).source == nullptr);
  assert(sameUtcFixTime("091918.00", "091918"));
  assert(sameUtcFixTime("091918.10", "091918.1"));
  assert(!sameUtcFixTime("091918.00", "091919.00"));
  assert(!sameUtcFixTime("091918.10", "091918.11"));
  assert(!sameUtcFixTime("091918", "091918.bad"));
  assert(!sameUtcFixTime("091918.", "091918."));
  assert(std::abs(10 * knotsToMps - 5.14444) < 0.00001);
}
