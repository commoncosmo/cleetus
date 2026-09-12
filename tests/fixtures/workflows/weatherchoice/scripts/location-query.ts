const supplied = Bun.argv.slice(2);

if (supplied.length !== 2) {
  throw new Error("expected exactly two city inputs");
}

function cityName(value: string): string {
  const city = value.split(",", 1)[0]?.trim();
  if (!city || city.length < 2) {
    throw new Error(`invalid city input '${value}'`);
  }
  return city;
}

console.log(
  JSON.stringify({
    city_a: cityName(supplied[0]!),
    city_b: cityName(supplied[1]!),
  }),
);
